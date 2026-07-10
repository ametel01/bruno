import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AuthModeConfigurationError,
  requireValidAuthMode,
  resolveAuthMode,
} from "@/src/auth/auth-mode";

const COMPLETE_CLERK_ENV = {
  AGENTBAY_AUTH_MODE: "clerk",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
  CLERK_SECRET_KEY: "secret-key-present",
} as const;

describe("authentication mode policy", () => {
  it.each([
    "http://localhost:3000",
    "http://agentbay.localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.42.0.8:3000",
    "http://[::1]:3000",
  ])("defaults an unset non-Vercel loopback %s to development", (appUrl) => {
    expect(resolveAuthMode({ NEXT_PUBLIC_APP_URL: appUrl })).toEqual({ mode: "development" });
  });

  it("accepts an explicit local development mode without Clerk keys", () => {
    expect(
      resolveAuthMode({
        AGENTBAY_AUTH_MODE: "development",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      }),
    ).toEqual({ mode: "development" });
  });

  it.each([
    "",
    " ",
    "DEVELOPMENT",
    "development ",
    "operator",
    "unknown",
  ])("fails closed for invalid mode %j", (mode) => {
    expect(
      resolveAuthMode({
        AGENTBAY_AUTH_MODE: mode,
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      }),
    ).toEqual({ mode: "invalid", code: "invalid_auth_mode" });
  });

  it("requires complete Clerk configuration", () => {
    for (const env of [
      { AGENTBAY_AUTH_MODE: "clerk" },
      {
        AGENTBAY_AUTH_MODE: "clerk",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
      },
      {
        AGENTBAY_AUTH_MODE: "clerk",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
        CLERK_SECRET_KEY: " ",
      },
    ]) {
      expect(resolveAuthMode(env)).toEqual({
        mode: "invalid",
        code: "clerk_auth_not_configured",
      });
    }

    expect(resolveAuthMode(COMPLETE_CLERK_ENV)).toEqual({
      mode: "clerk",
      publishableKey: "publishable-key-present",
    });
  });

  it("defaults an unset Vercel preview to Clerk with complete keys", () => {
    expect(
      resolveAuthMode({
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
        CLERK_SECRET_KEY: "secret-key-present",
        VERCEL_ENV: "preview",
      }),
    ).toEqual({
      mode: "clerk",
      publishableKey: "publishable-key-present",
    });
  });

  it.each([
    ["both keys missing", undefined, undefined],
    ["secret key missing", "publishable-key-present", undefined],
    ["publishable key missing", undefined, "secret-key-present"],
    ["blank secret key", "publishable-key-present", " "],
  ])("fails an unset Vercel preview closed when %s", (_label, publishableKey, secretKey) => {
    expect(
      resolveAuthMode({
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_SECRET_KEY: secretKey,
        VERCEL_ENV: "preview",
      }),
    ).toEqual({ mode: "invalid", code: "clerk_auth_not_configured" });
  });

  it("permits only an explicit, attested development mode on the current Vercel preview", () => {
    const previewEnv = {
      AGENTBAY_AUTH_MODE: "development",
      AGENTBAY_PREVIEW_PROTECTION_VERIFIED: "true",
      NEXT_PUBLIC_APP_URL: "https://agentbay-git-feature.example.vercel.app",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "agentbay-git-feature.example.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "agentbay.example.vercel.app",
    };

    expect(resolveAuthMode(previewEnv)).toEqual({ mode: "development" });

    expect(resolveAuthMode({ ...previewEnv, AGENTBAY_AUTH_MODE: undefined })).toEqual({
      mode: "invalid",
      code: "clerk_auth_not_configured",
    });

    for (const attestation of [undefined, "", " ", "TRUE", "false"]) {
      expect(
        resolveAuthMode({
          ...previewEnv,
          AGENTBAY_PREVIEW_PROTECTION_VERIFIED: attestation,
        }),
      ).toEqual({ mode: "invalid", code: "preview_protection_not_verified" });
    }
  });

  it.each([
    ["missing hosts", undefined, undefined],
    ["malformed hosts", "not a URL", "not a hostname"],
    ["missing app host", undefined, "agentbay-git-feature.example.vercel.app"],
    ["missing current preview host", "https://agentbay-git-feature.example.vercel.app", undefined],
  ])("refuses an attested development preview with %s", (_label, appUrl, vercelUrl) => {
    expect(
      resolveAuthMode({
        AGENTBAY_AUTH_MODE: "development",
        AGENTBAY_PREVIEW_PROTECTION_VERIFIED: "true",
        NEXT_PUBLIC_APP_URL: appUrl,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_URL: vercelUrl,
      }),
    ).toEqual({ mode: "invalid", code: "development_auth_not_allowed" });
  });

  it.each([
    ["mismatched current deployment", "https://other.example.vercel.app"],
    ["custom preview hostname", "https://preview.example.com"],
    ["production hostname", "https://plingpling.xyz"],
  ])("refuses preview development mode for a %s", (_label, appUrl) => {
    expect(
      resolveAuthMode({
        AGENTBAY_AUTH_MODE: "development",
        AGENTBAY_PREVIEW_PROTECTION_VERIFIED: "true",
        NEXT_PUBLIC_APP_URL: appUrl,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_URL: "agentbay-git-feature.example.vercel.app",
        VERCEL_PROJECT_PRODUCTION_URL: "agentbay.example.vercel.app",
      }),
    ).toEqual({ mode: "invalid", code: "development_auth_not_allowed" });
  });

  it("refuses a custom hostname even when VERCEL_URL matches it", () => {
    expect(
      resolveAuthMode({
        AGENTBAY_AUTH_MODE: "development",
        AGENTBAY_PREVIEW_PROTECTION_VERIFIED: "true",
        NEXT_PUBLIC_APP_URL: "https://preview.example.com",
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_URL: "preview.example.com",
      }),
    ).toEqual({ mode: "invalid", code: "development_auth_not_allowed" });
  });

  it.each([
    ["Vercel production", { VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost" }],
    ["production domain", { NEXT_PUBLIC_APP_URL: "https://plingpling.xyz" }],
    ["production subdomain", { NEXT_PUBLIC_APP_URL: "https://www.plingpling.xyz" }],
    ["custom hostname", { NEXT_PUBLIC_APP_URL: "https://agentbay.example.com" }],
    [
      "configured Vercel production hostname",
      {
        NEXT_PUBLIC_APP_URL: "https://agentbay.example.vercel.app",
        VERCEL_PROJECT_PRODUCTION_URL: "agentbay.example.vercel.app",
      },
    ],
    ["ambiguous Vercel marker", { NEXT_PUBLIC_APP_URL: "http://localhost", VERCEL: "1" }],
    ["DNS name beginning 127", { NEXT_PUBLIC_APP_URL: "https://127.attacker.example" }],
    [
      "DNS name extending an IPv4 loopback",
      { NEXT_PUBLIC_APP_URL: "https://127.0.0.1.attacker.example" },
    ],
  ])("requires Clerk instead of development for %s", (_label, env) => {
    expect(resolveAuthMode({ AGENTBAY_AUTH_MODE: "development", ...env })).toEqual({
      mode: "invalid",
      code: "development_auth_not_allowed",
    });
  });

  it("does not infer deployment trust from NODE_ENV", () => {
    expect(
      resolveAuthMode({
        AGENTBAY_AUTH_MODE: "development",
        NEXT_PUBLIC_APP_URL: "https://plingpling.xyz",
        NODE_ENV: "development",
      }),
    ).toEqual({ mode: "invalid", code: "development_auth_not_allowed" });

    expect(
      resolveAuthMode({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NODE_ENV: "production",
      }),
    ).toEqual({ mode: "development" });
  });

  it("returns generic errors without reflecting configuration values", () => {
    const secret = "secret-value-that-must-not-appear";

    expect(() =>
      requireValidAuthMode({
        AGENTBAY_AUTH_MODE: "clerk",
        NEXT_PUBLIC_APP_URL: "https://plingpling.xyz",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: secret,
      }),
    ).toThrowError(AuthModeConfigurationError);

    try {
      requireValidAuthMode({
        AGENTBAY_AUTH_MODE: "clerk",
        NEXT_PUBLIC_APP_URL: "https://plingpling.xyz",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: secret,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("keeps request host input and the retired transition variable outside the policy", () => {
    const proxySource = readFileSync("proxy.ts", "utf8");
    const authModeSource = readFileSync("src/auth/auth-mode.ts", "utf8");
    const serverAuthModeSource = readFileSync("src/auth/server-auth-mode.ts", "utf8");
    const serverConsumerSources = [
      proxySource,
      readFileSync("app/layout.tsx", "utf8"),
      readFileSync("app/_components/product-shell.tsx", "utf8"),
      readFileSync("app/sign-in/[[...sign-in]]/page.tsx", "utf8"),
      readFileSync("app/sign-up/[[...sign-up]]/page.tsx", "utf8"),
      readFileSync("src/server/users/configured-application-user.ts", "utf8"),
    ];
    const runtimeSources = [
      authModeSource,
      serverAuthModeSource,
      ...serverConsumerSources,
      readFileSync("scripts/vercel-build.ts", "utf8"),
    ].join("\n");

    expect(proxySource).not.toContain('headers.get("host")');
    expect(proxySource).not.toContain("x-forwarded-host");
    expect(authModeSource).not.toContain("NextRequest");
    expect(serverAuthModeSource).toContain('import "server-only"');
    for (const source of serverConsumerSources) {
      expect(source).toContain("@/src/auth/server-auth-mode");
    }
    expect(runtimeSources).not.toContain("AGENTBAY_AUTH_TRANSITION_MODE");
  });
});
