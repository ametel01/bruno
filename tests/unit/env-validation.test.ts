import { describe, expect, it } from "vitest";
import { EnvValidationError, validateRequiredEnv } from "@/src/env/validation";

describe("environment validation", () => {
  it("returns required values when environment variables are valid", () => {
    const env = validateRequiredEnv({
      DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/agentbay",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });

    expect(env).toEqual({
      DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:54329/agentbay",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });
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
