import { describe, expect, it } from "vitest";
import {
  MAX_DAILY_SPEND_DOLLARS,
  validateUpdateAgentConfigPayload,
} from "@/src/server/agents/update-agent-config";

describe("update agent config validation", () => {
  it("accepts editable config fields and normalizes strings, spend, schedule, and timezone", () => {
    expect(
      validateUpdateAgentConfigPayload({
        name: "  Research Agent  ",
        systemPrompt: "  Keep answers concise.  ",
        modelProvider: "  openai  ",
        modelName: "  gpt-4.1-mini  ",
        maxDailySpend: "12.34",
        scheduleMode: "cron",
        scheduleCron: "*/15 9-17 * * 1-5",
        timezone: "Asia/Manila",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Research Agent",
        systemPrompt: "Keep answers concise.",
        modelProvider: "openai",
        modelName: "gpt-4.1-mini",
        maxDailySpendCents: 1234,
        scheduleMode: "cron",
        scheduleCron: "*/15 9-17 * * 1-5",
        timezone: "Asia/Manila",
      },
    });
  });

  it("rejects malformed bodies, unknown fields, and blank required string fields", () => {
    expect(validateUpdateAgentConfigPayload(null)).toMatchObject({
      ok: false,
      issues: [{ field: "body" }],
    });
    expect(validateUpdateAgentConfigPayload(["modelName"])).toMatchObject({
      ok: false,
      issues: [{ field: "body" }],
    });
    expect(validateUpdateAgentConfigPayload({ displayName: "Agent" })).toMatchObject({
      ok: false,
      issues: [{ field: "body", message: 'Field "displayName" is not editable.' }],
    });
    expect(
      validateUpdateAgentConfigPayload({
        name: " ",
        systemPrompt: "",
        modelProvider: " ",
        modelName: "",
        timezone: " ",
      }),
    ).toMatchObject({
      ok: false,
      issues: [
        { field: "name" },
        { field: "systemPrompt" },
        { field: "modelProvider" },
        { field: "modelName" },
        { field: "timezone" },
      ],
    });
  });

  it("rejects invalid spend before converting to integer cents", () => {
    for (const maxDailySpend of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1.234", "abc"]) {
      expect(validateUpdateAgentConfigPayload({ maxDailySpend })).toMatchObject({
        ok: false,
        issues: [{ field: "maxDailySpend" }],
      });
    }

    expect(
      validateUpdateAgentConfigPayload({ maxDailySpend: MAX_DAILY_SPEND_DOLLARS + 0.01 }),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "maxDailySpend" }],
    });
  });

  it("rejects invalid schedule and timezone values", () => {
    expect(validateUpdateAgentConfigPayload({ scheduleMode: "hourly" })).toMatchObject({
      ok: false,
      issues: [{ field: "scheduleMode" }],
    });
    expect(validateUpdateAgentConfigPayload({ scheduleCron: "60 * * * *" })).toMatchObject({
      ok: false,
      issues: [{ field: "scheduleCron" }],
    });
    expect(validateUpdateAgentConfigPayload({ scheduleCron: "" })).toMatchObject({
      ok: false,
      issues: [{ field: "scheduleCron" }],
    });
    expect(validateUpdateAgentConfigPayload({ timezone: "Mars/Base" })).toMatchObject({
      ok: false,
      issues: [{ field: "timezone" }],
    });
  });

  it("rejects secret-like keys recursively without echoing secret values", () => {
    const validation = validateUpdateAgentConfigPayload({
      modelName: "gpt-4.1-mini",
      nested: {
        credentials: [
          {
            apiKey: "sk-live-should-not-appear",
          },
        ],
      },
    });

    expect(validation).toMatchObject({
      ok: false,
      issues: [{ field: "body" }],
    });
    expect(JSON.stringify(validation)).not.toContain("sk-live-should-not-appear");
  });
});
