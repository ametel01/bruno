import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createAppLogger,
  LOG_REDACTION_CENSOR,
  normalizeLogLevel,
} from "@/src/server/logging/logger";

describe("production logger", () => {
  it("writes structured JSON with stable service, component, lifecycle, and level fields", () => {
    const output = captureLogs();
    const logger = createAppLogger("runner.provisioning", {
      level: "debug",
      stream: output.stream,
      base: { environment: "test" },
    }).child({ lifecycle: "droplet_creation", lifecycleId: "operation-123" });

    logger.info("provider_create_started", {
      runnerId: "runner-123",
      region: "sgp1",
    });

    expect(output.records()).toEqual([
      expect.objectContaining({
        service: "bruno",
        environment: "test",
        component: "runner.provisioning",
        lifecycle: "droplet_creation",
        lifecycleId: "operation-123",
        level: "info",
        event: "provider_create_started",
        message: "provider_create_started",
        runnerId: "runner-123",
        region: "sgp1",
        time: expect.any(String),
      }),
    ]);
  });

  it("recursively redacts credentials from metadata, messages, errors, and causes", () => {
    const output = captureLogs();
    const logger = createAppLogger("agent.create", {
      level: "info",
      stream: output.stream,
      base: { environment: "test" },
    });
    const cause = new Error(
      "request used Bearer bruno_run_123456 and postgres://admin:password@db.internal/bruno",
    );
    const error = new Error("provider token=dop_v1_super_secret failed", { cause });
    Object.assign(error, { registrationToken: "bruno_reg_123456", safeCount: 2 });

    logger.error(
      "provider_create_failed",
      error,
      {
        authorization: "Bearer bruno_run_123456",
        nested: {
          apiKey: "sk-production-secret",
          cookie: "session=secret",
          runnerBearerTokenFingerprint: "sha256:safe",
        },
      },
      "provider failed with api_key=sk-production-secret",
    );

    const [record] = output.records();
    const serialized = JSON.stringify(record);

    expect(record).toMatchObject({
      authorization: LOG_REDACTION_CENSOR,
      nested: {
        apiKey: LOG_REDACTION_CENSOR,
        cookie: LOG_REDACTION_CENSOR,
        runnerBearerTokenFingerprint: "sha256:safe",
      },
      error: {
        type: "Error",
        safeCount: 2,
        registrationToken: LOG_REDACTION_CENSOR,
        cause: { type: "Error" },
      },
    });
    expect(serialized).not.toContain("bruno_run_123456");
    expect(serialized).not.toContain("bruno_reg_123456");
    expect(serialized).not.toContain("dop_v1_super_secret");
    expect(serialized).not.toContain("sk-production-secret");
    expect(serialized).not.toContain("admin:password");
    expect(record?.message).toBe(`provider failed with api_key=${LOG_REDACTION_CENSOR}`);
  });

  it("filters events below the configured threshold and safely defaults invalid levels", () => {
    const output = captureLogs();
    const logger = createAppLogger("agent.deployment", {
      level: "warn",
      stream: output.stream,
      base: { environment: "test" },
    });

    logger.info("stage_started");
    logger.warn("retry_scheduled", { attemptCount: 2 });

    expect(output.records()).toEqual([
      expect.objectContaining({
        level: "warn",
        event: "retry_scheduled",
        attemptCount: 2,
      }),
    ]);
    expect(normalizeLogLevel(" DEBUG ")).toBe("debug");
    expect(normalizeLogLevel("verbose")).toBe("info");
    expect(normalizeLogLevel(undefined)).toBe("info");
  });
});

function captureLogs(): { stream: PassThrough; records: () => Array<Record<string, unknown>> } {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  return {
    stream,
    records: () =>
      output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
