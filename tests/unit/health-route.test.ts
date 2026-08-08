import { describe, expect, it } from "vitest";
import { GET } from "@/app/health/route";

describe("GET /health", () => {
  it("returns non-2xx sanitized JSON when required database configuration is invalid", async () => {
    const response = await GET(undefined, undefined, {
      checkHealth: async () => ({
        ok: false,
        database: "unreachable" as const,
        message: "DATABASE_URL must be a valid URL.",
      }),
      readDispatchConfig: () => ({ ok: true, mode: "cron" as const }),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      database: "unreachable",
      deploymentDispatch: "cron",
      timestamp: "2026-08-09T00:00:00.000Z",
      message: "DATABASE_URL must be a valid URL.",
    });
  });

  it("reports the active deployment dispatch mode without configuration secrets", async () => {
    const response = await GET(undefined, undefined, {
      checkHealth: async () => ({ ok: true, database: "reachable" as const }),
      readDispatchConfig: () => ({
        ok: true,
        mode: "qstash" as const,
        token: "private-qstash-token",
        currentSigningKey: "private-current-key",
        nextSigningKey: "private-next-key",
        callbackBaseUrl: "https://private.example.test",
        maxPublishAttempts: 12,
      }),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      database: "reachable",
      deploymentDispatch: "qstash",
      timestamp: "2026-08-09T00:00:00.000Z",
    });
  });

  it("fails health closed when selected QStash configuration is incomplete", async () => {
    const response = await GET(undefined, undefined, {
      checkHealth: async () => ({ ok: true, database: "reachable" as const }),
      readDispatchConfig: () => ({
        ok: false,
        reason: "deployment_dispatch_configuration_invalid" as const,
      }),
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      database: "reachable",
      deploymentDispatch: "invalid",
      timestamp: "2026-08-09T00:00:00.000Z",
      message: "Deployment dispatch configuration is invalid.",
    });
  });
});
