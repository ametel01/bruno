import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentHermesSetup } from "@/app/agents/_components/agent-hermes-setup";
import {
  buildHermesSetupReadiness,
  OPENROUTER_MODEL_OPTIONS,
} from "@/src/server/agents/hermes-readiness";
import type { AgentSecretStatus } from "@/src/server/agents/agent-secrets";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

describe("AgentHermesSetup", () => {
  it("renders readiness and secret states without exposing submitted secret values", () => {
    const html = renderToStaticMarkup(
      createElement(AgentHermesSetup, {
        agentId: "00000000-0000-4000-8000-000000000401",
        modelProvider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        modelOptions: OPENROUTER_MODEL_OPTIONS,
        readiness: buildHermesSetupReadiness({
          config: {
            systemPrompt: "You are a test agent.",
            modelProvider: "openrouter",
            modelName: "openai/gpt-4.1-mini",
            maxDailySpendCents: 0,
            scheduleMode: "manual",
            scheduleCron: null,
            timezone: "UTC",
            updatedAt: "2026-07-14T01:00:00.000Z",
          },
          secretStatuses: [
            secretStatus("openrouter_api_key", "2026-07-14T01:01:00.000Z"),
            secretStatus("telegram_bot_token", "2026-07-14T01:02:00.000Z"),
            secretStatus("api_server_key", "2026-07-14T01:03:00.000Z"),
          ],
          assignedRunner: null,
        }),
        secrets: [
          secretStatus("openrouter_api_key", "2026-07-14T01:01:00.000Z"),
          secretStatus("telegram_bot_token", "2026-07-14T01:02:00.000Z"),
          secretStatus("api_server_key", "2026-07-14T01:03:00.000Z"),
        ],
      }),
    );

    expect(html).toContain("Hermes setup");
    expect(html).toContain("OpenRouter model");
    expect(html).toContain("Telegram allowed users");
    expect(html).toContain("Agent API server key");
    expect(html).toContain("Replace");
    expect(html).toContain("Rotate");
    expect(html).not.toContain("sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz");
    expect(html).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
    expect(html).not.toContain("telegram_allowed_users=123456789");
  });
});

function secretStatus(kind: AgentSecretStatus["kind"], updatedAt: string): AgentSecretStatus {
  return {
    kind,
    configured: true,
    fingerprint: "0123456789abcdef",
    status: "active",
    createdAt: updatedAt,
    updatedAt,
    rotatedAt: null,
    revokedAt: null,
  };
}
