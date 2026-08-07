import { describe, expect, it } from "vitest";
import { EnvValidationError, validateRequiredEnv } from "@/src/env/validation";

describe("environment validation", () => {
  it("returns required values when environment variables are valid", () => {
    const env = validateRequiredEnv({
      DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });

    expect(env).toEqual({
      DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });
  });

  it("accepts optional manual runner HTTPS and loopback HTTP endpoints", () => {
    expect(
      validateRequiredEnv({
        DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AGENTBAY_MANUAL_RUNNER_NAME: "  Dev VPS  ",
        AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: " https://runner.example.com ",
      }),
    ).toMatchObject({
      AGENTBAY_MANUAL_RUNNER_NAME: "Dev VPS",
      AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: "https://runner.example.com",
    });

    expect(
      validateRequiredEnv({
        DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: "http://127.0.0.1:8787",
      }),
    ).toMatchObject({
      AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: "http://127.0.0.1:8787",
    });

    expect(
      validateRequiredEnv({
        DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: "http://host.docker.internal:3045",
      }),
    ).toMatchObject({
      AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: "http://host.docker.internal:3045",
    });
  });

  it("rejects blank, malformed, and non-HTTPS remote manual runner endpoints", () => {
    expect(() =>
      validateRequiredEnv({
        DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: " ",
      }),
    ).toThrow("AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL cannot be blank.");

    expect(() =>
      validateRequiredEnv({
        DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: "runner.example.com",
      }),
    ).toThrow("AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL must be a valid URL.");

    expect(() =>
      validateRequiredEnv({
        DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/bruno",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: "http://runner.example.com",
      }),
    ).toThrow(
      "AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL must use https:// unless it targets a loopback host.",
    );
  });

  it("reports all missing required environment variables", () => {
    expect(() => validateRequiredEnv({})).toThrowError(EnvValidationError);

    try {
      validateRequiredEnv({});
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues).toEqual([
        "DATABASE_URL is required.",
        "NEXT_PUBLIC_APP_URL is required.",
      ]);
    }
  });

  it("reports malformed required environment variables", () => {
    expect(() =>
      validateRequiredEnv({
        DATABASE_URL: "https://example.com/database",
        NEXT_PUBLIC_APP_URL: "agentbay.local",
      }),
    ).toThrowError(
      "Environment validation failed: DATABASE_URL must use the postgres:// or postgresql:// protocol. NEXT_PUBLIC_APP_URL must be a valid URL.",
    );
  });
});
