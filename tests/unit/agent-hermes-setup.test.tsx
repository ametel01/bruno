import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentHermesSetup } from "@/app/agents/_components/agent-hermes-setup";
import { buildHermesSetupReadiness } from "@/src/server/agents/hermes-readiness";
import type { AgentSecretStatus } from "@/src/server/agents/agent-secrets";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

describe("AgentHermesSetup", () => {
  it("renders the native Hermes setup action without provider key fields", () => {
    const html = renderToStaticMarkup(
      createElement(AgentHermesSetup, {
        agentId: "00000000-0000-4000-8000-000000000401",
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
          secretStatuses: [secretStatus("api_server_key", "2026-07-14T01:03:00.000Z")],
          assignedRunner: null,
        }),
      }),
    );

    expect(html).toContain("Hermes setup");
    expect(html).toContain("Open Hermes setup");
    expect(html).toContain("Runner ready");
    expect(html).not.toContain("OpenRouter API key");
    expect(html).not.toContain("Telegram bot token");
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
