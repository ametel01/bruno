import { describe, expect, it } from "vitest";
import {
  parseAgentLaunchSpec,
  parseAgentLaunchSpecJson,
  redactAgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import { sampleLaunchSpec } from "@/tests/helpers/agent-launch-spec";

describe("AgentLaunchSpec", () => {
  it("accepts the versioned Hermes launch contract and redacts inline secrets", () => {
    const spec = sampleLaunchSpec();
    const parsed = parseAgentLaunchSpec(spec);

    expect(parsed).toEqual({ ok: true, spec });
    expect(redactAgentLaunchSpec(spec)).toMatchObject({
      secrets: {
        openrouterApiKey: "[secret]",
        telegramBotToken: "[secret]",
        telegramAllowedUsers: "[secret]",
        apiServerKey: "[secret]",
      },
    });
    expect(JSON.stringify(redactAgentLaunchSpec(spec))).not.toContain(
      spec.secrets.openrouterApiKey,
    );
  });

  it("rejects stale versions, unknown fields, malformed Telegram allowlists, and oversized JSON", () => {
    const stale = {
      ...sampleLaunchSpec(),
      version: "agentbay.hermes.launch.v0",
      unexpected: true,
      secrets: {
        ...sampleLaunchSpec().secrets,
        telegramAllowedUsers: "*",
      },
    };
    const parsed = parseAgentLaunchSpec(stale);

    expect(parsed.ok).toBe(false);
    expect(parsed).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "$.version" }),
        expect.objectContaining({ path: "$.unexpected" }),
        expect.objectContaining({ path: "$.secrets.telegramAllowedUsers" }),
      ]),
    });

    expect(parseAgentLaunchSpecJson("{")).toMatchObject({ ok: false });
    expect(parseAgentLaunchSpecJson(JSON.stringify({ value: "x".repeat(70 * 1024) }))).toEqual({
      ok: false,
      issues: [{ path: "$", message: "Launch spec body is too large." }],
    });
  });
});
